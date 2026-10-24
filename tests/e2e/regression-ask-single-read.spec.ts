// Acceptance E2E — every conversation turn is one grounded read that answers
// (Story MOTIR-9216 · MOTIR-9234; `conversation-turn-intent.md` AMENDMENT 5).
//
// The browser-level proof of the story, walking its Verification recipe:
//
//   A. A question, a defect report and "let's plan something else" are each READ
//      and ANSWERED with citations. The record's first line is the reading act,
//      nothing names classifying or debugging, no bug is filed, no new-session
//      confirm is drawn, and Plan something new is still in the rail head. A turn
//      that cannot be paid for draws the shipped out-of-credits state and writes
//      nothing.
//   B. The report widget's one seeded send is ANCHORED on the bug it filed; the
//      answer cites that bug, and the turn persisted the anchor.
//   C. An unavailable code graph and a repository that is not indexed each open
//      the answer with the code-was-not-read lead and draw the notice; a readable
//      graph draws neither.
//   D. Typed into a planning run in progress, a question is answered on the side
//      and a clear change is forwarded to the planner, as before.
//   E. A stored `debug` turn with its landing, and a stored `new_session` turn with
//      its confirm, reload and render as they did before the story.
//   F. In Chinese, the question case shows no English fallback and no raw key.
//
// ── THE BOUNDARY ────────────────────────────────────────────────────────────
// Runs under playwright.acceptance.config.ts (MOTIR_CLOUD + video: 'on'), where
// motir-ai is mocked UNDER the routes by `lib/test-ai-jobs-mock.ts`. The mock
// stands in for the grounded read — it answers what it is told it read — so no
// assertion here tests motir-ai's own behaviour (the motir-ai gate owns that);
// the spec asserts what the browser draws and what core persists.
//
// ── THE WAITS ───────────────────────────────────────────────────────────────
// Every wait is the response of a request the page issued, a landmark, or a row in
// Postgres. The FIRST progress line is transient by design — the reading act is
// taken out of the record once the ask settles (MOTIR-7924) — so the spec HOLDS the
// page's own settle request (`page.route`) until it has seen the line, then lets it
// through: a gate the spec opens, never a timer.
import type { Page, Response } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import {
  seedAiAugmentReplan,
  markProjectOnboarded,
  type AiAugmentReplanSeed,
} from './_helpers/ai-augment-replan-seed';
import {
  declareSeam,
  queueAsk,
  submitted,
  submitsOf,
  planRun,
  planOfRun,
  mailboxRows,
} from './_helpers/mid-run-seam';
import { setReaderLanguage } from './_helpers/reader-language';
import { withPlanningOverlay } from '@/lib/planning/launcher';
import { PROJECT_SCOPE } from '@/lib/planChange/scope';
import type { ProjectContext } from '@/lib/projects';
import type { DebugLandingDto } from '@/lib/dto/planChange';
import { projectsService } from '@/lib/services/projectsService';
import { planChangeSessionsService } from '@/lib/services/planChangeSessionsService';
import { workItemsService } from '@/lib/services/workItemsService';
import en from '@/messages/en.json';
import zh from '@/messages/zh.json';

test.describe.configure({ timeout: 240_000 });

const conv = en.planningWorkspace.conversation;
const outage = en.planningWorkspace.codeUnreadable;
const restart = en.planningWorkspace.restart;

/** motir-ai's English code-was-not-read lead (`OUTAGE_LEADS.en`, codeOutageRule.ts). */
const OUTAGE_LEAD = "I couldn't read your code for this answer.";

// ── Locators ────────────────────────────────────────────────────────────────

const workspace = (page: Page) => page.getByRole('dialog', { name: /plan/i });
const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });
const composer = (page: Page) => rail(page).getByRole('textbox');
const orb = (page: Page) => page.getByRole('button', { name: 'Motir AI', exact: true });
const calloutPanel = (page: Page) => page.getByRole('dialog', { name: 'Motir AI' });
const entrance = (page: Page) => page.getByRole('main').getByTestId('work-item-plan-entrance');
const byId = (page: Page, id: string | RegExp) => rail(page).getByTestId(id);
const answers = (page: Page) => byId(page, 'plan-change-report');
const answer = (page: Page, text: string) => answers(page).filter({ hasText: text });
const chip = (page: Page, text: string, key: string) =>
  answer(page, text).locator('a.wi-chip').filter({ hasText: key });
const firstAct = (page: Page) => byId(page, 'plan-change-acts').locator('li').first();
/** Every act a retired debug or classifier turn drew (MOTIR-9232 removed them). */
const RETIRED_ACTS = /^plan-change-(act-(matching|writing|redirected)|handoff-debug)$/;

const overlayOpen = (url: URL) => url.searchParams.has('plan');

// ── Authoritative signals ───────────────────────────────────────────────────

const ASK = '/api/ai/ask';
const SETTLE = '/api/ai/ask/settle';
const pathOf = (r: Response) => new URL(r.url()).pathname;
const isPost = (r: Response, pathname: string) =>
  pathOf(r) === pathname && r.request().method() === 'POST';

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

/**
 * HOLD the page's settle requests until the returned release is called. The ask's
 * record draws its reading act while the job runs and drops it on the settle, so
 * this is what makes the first line observable without a timer.
 */
async function holdSettle(page: Page): Promise<() => Promise<void>> {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const handler = async (route: Parameters<Parameters<Page['route']>[1]>[0]) => {
    await gate;
    await route.continue();
  };
  await page.route(`**${SETTLE}`, handler);
  return async () => {
    open();
    await page.unroute(`**${SETTLE}`, handler);
  };
}

interface Asked {
  /** The ask door's request body, as the page sent it. */
  request: { body?: string; anchorKey?: string };
  /** The settle's answer. */
  settled: { outcome?: string };
}

/**
 * Send a turn and see it READ: the ask door's 200, the record's first line — the
 * reading act, with nothing classifying or debugging beside it — then the settle.
 * `send` performs the action that sends (the composer by default).
 */
async function askAndSeeItRead(
  page: Page,
  text: string,
  send?: () => Promise<void>,
  readingLabel: string = conv.act.reading,
): Promise<Asked> {
  const release = await holdSettle(page);
  const asked = page.waitForResponse((r) => isPost(r, ASK));
  const settled = page.waitForResponse((r) => isPost(r, SETTLE));
  if (send) {
    await send();
  } else {
    await composer(page).fill(text);
    await rail(page).getByRole('button', { name: conv.send, exact: true }).click();
  }
  const askRes = await asked;
  expect(askRes.status(), await askRes.text()).toBe(200);
  try {
    await expect(firstAct(page)).toHaveAttribute('data-testid', 'plan-change-act-reading');
    await expect(firstAct(page)).toContainText(readingLabel);
    await expect(byId(page, RETIRED_ACTS)).toHaveCount(0);
    await expect(rail(page)).not.toContainText(/classif/i);
  } finally {
    await release();
  }
  const settleRes = await settled;
  expect(settleRes.status(), await settleRes.text()).toBe(200);
  return {
    request: JSON.parse(askRes.request().postData() ?? '{}') as Asked['request'],
    settled: (await settleRes.json()) as Asked['settled'],
  };
}

// ── Persisted state ─────────────────────────────────────────────────────────

const bugCount = (projectId: string) =>
  adminDb.workItem.count({ where: { projectId, kind: 'bug' } });
const itemCount = (projectId: string) => adminDb.workItem.count({ where: { projectId } });
const assistantTurns = () => adminDb.planChangeTurn.count({ where: { role: 'assistant' } });
const userTurnRow = (body: string) =>
  adminDb.planChangeTurn.findFirstOrThrow({
    where: { role: 'user', body },
    orderBy: { seq: 'desc' },
    select: { intent: true, anchorKey: true, confirm: true },
  });
const workItemId = async (key: string) =>
  (await adminDb.workItem.findFirstOrThrow({ where: { identifier: key } })).id;
/** A cited answer's prose, with the chip motir-ai's markdown link draws. */
const citing = async (key: string, prose: string) =>
  `[${key}](motir:${await workItemId(key)}) ${prose}`;

/** No retired job ran, ever, in this test. */
function expectNoRetiredJob(): void {
  expect(submitted().filter((s) => s.kind === 'debug_bug')).toEqual([]);
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

async function projectContext(seed: AiAugmentReplanSeed): Promise<ProjectContext> {
  const project = await projectsService.getActiveProject(seed.ctx.userId, seed.ctx.workspaceId);
  if (!project) throw new Error('the seed has no active project');
  return {
    userId: seed.ctx.userId,
    workspaceId: seed.ctx.workspaceId,
    projectId: seed.projectId,
    project,
  };
}

let seed: AiAugmentReplanSeed;

test.beforeEach(async ({ page }) => {
  await resetDatabase();
  declareSeam({ ask: [] });
  seed = await seedAiAugmentReplan(`ask-single-read-${Date.now()}@example.com`);
  await markProjectOnboarded(seed.projectId);
  await stubAiAccess(page);
  await signIn(page, seed.email, seed.password);
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ═══ A. Three kinds of turn, one read each ══════════════════════════════════

test('A. a question, a defect report and "plan something else" are each read and answered', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-9216');
  const QUESTION = `what is ${seed.loginKey} about?`;
  const QUESTION_ANSWER = 'is the sign-in screen, and nothing blocks it.';
  const DEFECT = 'saving a comment drops the @mention';
  const DEFECT_ANSWER =
    'lib/services/commentsService.ts stores the body after the sanitizer runs, and the sanitizer drops the mention: scheme.';
  const ELSEWHERE = "forget this, let's plan something else";
  const ELSEWHERE_ANSWER =
    'Happy to. Tell me what to plan, or press Plan something new to start a fresh conversation.';
  queueAsk(
    {
      intent: 'ask',
      answer: await citing(seed.loginKey, QUESTION_ANSWER),
      citations: [seed.loginKey],
    },
    {
      intent: 'ask',
      answer: await citing(seed.billingKey, DEFECT_ANSWER),
      citations: [seed.billingKey],
    },
    {
      intent: 'ask',
      answer: await citing(seed.notifKey, ELSEWHERE_ANSWER),
      citations: [seed.notifKey],
    },
    { intent: 'ask', submit: 'out_of_credits' },
  );
  const bugsBefore = await bugCount(seed.projectId);

  /** After every turn: nothing a retired verdict would have drawn or written. */
  async function expectOnlyAnAnswer(text: string) {
    expect((await userTurnRow(text)).intent).toBe('ask');
    await expect(byId(page, 'plan-change-debug-outcome')).toHaveCount(0);
    await expect(byId(page, 'planning-restart-confirm-turn')).toHaveCount(0);
    await expect(byId(page, RETIRED_ACTS)).toHaveCount(0);
    expect(await bugCount(seed.projectId)).toBe(bugsBefore);
    expect(
      await adminDb.planChangeTurn.count({ where: { confirm: { not: null } } }),
      'no confirm turn was written',
    ).toBe(0);
    expectNoRetiredJob();
  }

  await chapter('A question is read, and answered with the work item it cites', async () => {
    await page.goto('/dashboard');
    await openProjectThread(page);
    const { settled } = await askAndSeeItRead(page, QUESTION);
    expect(settled.outcome).toBe('answered');
    await expect(answer(page, QUESTION_ANSWER)).toHaveCount(1);
    await expect(chip(page, QUESTION_ANSWER, seed.loginKey)).toBeVisible();
    await expect(
      answer(page, QUESTION_ANSWER).getByTestId('plan-change-citation-count'),
    ).toBeVisible();
    await expectOnlyAnAnswer(QUESTION);
    await beat();
  });

  await chapter('A defect report is read and answered — nothing is filed', async () => {
    const { settled } = await askAndSeeItRead(page, DEFECT);
    expect(settled.outcome).toBe('answered');
    await expect(answer(page, 'stores the body after the sanitizer')).toHaveCount(1);
    await expect(chip(page, 'stores the body after the sanitizer', seed.billingKey)).toBeVisible();
    await expect(rail(page).getByText(/Tracing the bug|Checking whether a work item/)).toHaveCount(
      0,
    );
    await expectOnlyAnAnswer(DEFECT);
    await beat();
  });

  await chapter('"Plan something else" is answered too; the control stays', async () => {
    const { settled } = await askAndSeeItRead(page, ELSEWHERE);
    expect(settled.outcome).toBe('answered');
    await expect(answer(page, 'Happy to.')).toHaveCount(1);
    await expect(chip(page, 'Happy to.', seed.notifKey)).toBeVisible();
    await expect(rail(page).getByText(restart.confirm.body)).toHaveCount(0);
    await expect(byId(page, 'planning-restart-control')).toBeVisible();
    await expect(byId(page, 'planning-restart-control')).toContainText(restart.control);
    await expectOnlyAnAnswer(ELSEWHERE);
    // Three asks, three `ask_project` jobs — and no plan-edit job.
    expect(submitsOf('ask_project')).toHaveLength(3);
    expect(submitsOf('plan')).toHaveLength(0);
    await beat();
  });

  await chapter('Out of credits: the shipped state, and nothing written', async () => {
    const replies = await assistantTurns();
    const items = await itemCount(seed.projectId);
    const asked = page.waitForResponse((r) => isPost(r, ASK));
    await composer(page).fill('what changed this week?');
    await rail(page).getByRole('button', { name: conv.send, exact: true }).click();
    expect((await asked).status()).toBe(402);
    await expect(rail(page).getByText(en.billing.paywall.outOfCredits.title)).toBeVisible();
    // PERSISTED: the submit was refused — no job, no answer, no card.
    const last = submitted().at(-1)!;
    expect(last).toMatchObject({ kind: 'ask_project', refused: true });
    expect(last.jobId).toBeUndefined();
    expect(submitsOf('ask_project')).toHaveLength(3);
    expect(await assistantTurns()).toBe(replies);
    expect(await itemCount(seed.projectId)).toBe(items);
    await beat();
  });
});

// ═══ B. The anchored ask ════════════════════════════════════════════════════

test('B. the report widget’s seeded send is anchored on the bug it filed, and cited', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-9216');
  const TITLE = 'CSV export drops the last row';
  const DESCRIPTION = 'Export a list of 10 work items to CSV — the file only has 9 rows.';
  const NEXT = 'needs the export loop to write its last row before it is ready to plan.';
  let filedKey = '';

  await chapter('A bug is reported from the header', async () => {
    await page.goto('/items');
    await expect(page.getByRole('treegrid', { name: 'Work Items', exact: true })).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    await page.getByRole('button', { name: 'Report' }).first().click();
    const modal = page.getByRole('dialog', { name: en.triage.widget.heading });
    await expect(modal).toBeVisible();
    await modal.getByRole('button', { name: en.triage.widget.kindBug, exact: true }).click();
    await modal.getByLabel(en.triage.widget.titleLabel).fill(TITLE);
    await modal.getByLabel(/What happened\?/).fill(DESCRIPTION);
    const created = page.waitForResponse(
      (r) => r.url().includes('/triage/submissions') && r.request().method() === 'POST',
    );
    await modal.getByRole('button', { name: en.triage.widget.submit }).click();
    const res = await created;
    expect(res.status()).toBe(201);
    filedKey = ((await res.json()) as { identifier: string }).identifier;
    await expect(modal.getByTestId('report-debug-filed')).toContainText(filedKey);
    await beat();
  });

  await chapter('Its one seeded send is read, and the answer cites that bug', async () => {
    queueAsk({ intent: 'ask', answer: await citing(filedKey, NEXT), citations: [filedKey] });
    const bugs = await bugCount(seed.projectId);
    const modal = page.getByRole('dialog', { name: en.triage.widget.heading });
    const { request, settled } = await askAndSeeItRead(page, TITLE, () =>
      modal.getByRole('button', { name: en.triage.widget.debugOffer.action }).click(),
    );
    // The SUBMITTED request carried the anchor, and the turn PERSISTED it.
    expect(request.anchorKey).toBe(filedKey);
    expect(request.body).toContain(TITLE);
    expect(settled.outcome).toBe('answered');
    const turn = await userTurnRow(`${TITLE}\n\n${DESCRIPTION}`);
    expect(turn).toMatchObject({ intent: 'ask', anchorKey: filedKey });

    await expect(answer(page, NEXT)).toHaveCount(1);
    await expect(chip(page, NEXT, filedKey)).toBeVisible();
    await expect(byId(page, 'plan-change-debug-outcome')).toHaveCount(0);
    // The read answered; it filed nothing beyond the report itself.
    expect(await bugCount(seed.projectId)).toBe(bugs);
    expectNoRetiredJob();
    await beat();
  });
});

// ═══ C. A code graph that could not be read ═════════════════════════════════

test('C. an unavailable graph and an unindexed repository each say the code was not read', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-9216');
  const UNAVAILABLE = `${OUTAGE_LEAD} From the work items, exports run through the CSV writer.`;
  const NOT_INDEXED = `${OUTAGE_LEAD} The repository has not been indexed yet, so this comes from the work items alone.`;
  const READABLE = 'The CSV writer streams each row as it reads it.';
  queueAsk(
    { intent: 'ask', answer: UNAVAILABLE, citations: [], codeUnreadable: 'hydrate_failed' },
    { intent: 'ask', answer: NOT_INDEXED, citations: [], codeUnreadable: 'not_indexed' },
    { intent: 'ask', answer: READABLE, citations: [] },
  );
  const notice = (page: Page) => byId(page, 'plan-change-code-unreadable-ask-notice');

  await page.goto('/dashboard');
  await openProjectThread(page);

  await chapter('The graph is unavailable: the lead, then the notice', async () => {
    await askAndSeeItRead(page, 'how does the CSV export work?');
    const reply = answer(page, 'exports run through the CSV writer');
    await expect(reply).toHaveCount(1);
    await expect(reply).toContainText(OUTAGE_LEAD);
    expect(((await reply.textContent()) ?? '').trim().startsWith(OUTAGE_LEAD)).toBe(true);
    await expect(notice(page)).toHaveCount(1);
    await expect(notice(page)).toContainText(outage.askNotice);
    await beat();
  });

  await chapter('The repository is not indexed: the lead, then the notice', async () => {
    await askAndSeeItRead(page, 'where is the export loop?');
    const reply = answer(page, 'has not been indexed yet');
    await expect(reply).toHaveCount(1);
    expect(((await reply.textContent()) ?? '').trim().startsWith(OUTAGE_LEAD)).toBe(true);
    await expect(notice(page)).toHaveCount(2);
    await beat();
  });

  await chapter('The graph reads again: neither the lead nor the notice', async () => {
    await askAndSeeItRead(page, 'and how are rows written?');
    const reply = answer(page, READABLE);
    await expect(reply).toHaveCount(1);
    await expect(reply).not.toContainText(OUTAGE_LEAD);
    // Still the two from before, and none on the new answer.
    await expect(notice(page)).toHaveCount(2);
    const faces = await adminDb.planChangeTurn.findMany({
      where: { role: 'assistant' },
      orderBy: { seq: 'asc' },
      select: { codeUnreadable: true },
    });
    expect(faces.map((f) => f.codeUnreadable)).toEqual(['answered', 'answered', null]);
    await beat();
  });
});

// ═══ D. A planning run in flight ════════════════════════════════════════════

test('D. in a running plan, a question is answered on the side and a change is forwarded', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-9216');
  const PROGRESS = 'It is laying the notifications step now.';
  const CHANGE = 'add a test card for exports';
  declareSeam({
    ask: [
      { intent: 'ask', answer: PROGRESS },
      { intent: 'plan_change', forward: { text: CHANGE } },
    ],
  });
  let jobId = '';

  await chapter('A run is working', async () => {
    await page.goto(`/items/${seed.loginKey}`);
    await expect(entrance(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await entrance(page).click();
    await page.waitForURL(overlayOpen);
    await expect(rail(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    const started = page.waitForResponse(
      (r) =>
        /\/api\/work-items\/[^/]+\/ai\/plan$/.test(pathOf(r)) && r.request().method() === 'POST',
    );
    await composer(page).fill('Plan the notifications digest.');
    await rail(page).getByRole('button', { name: conv.send, exact: true }).click();
    expect((await started).status()).toBe(200);
    await expect(byId(page, 'plan-change-stop')).toBeVisible();
    jobId = planRun(0).jobId;
    expect((await planOfRun(jobId)).sessionId).toBeTruthy();
    await beat();
  });

  await chapter('"How far along are you?" is answered on the side', async () => {
    const submit = page.waitForResponse((r) => isPost(r, ASK));
    const settle = page.waitForResponse((r) => isPost(r, SETTLE));
    await composer(page).fill('how far along are you?');
    await rail(page).getByRole('button', { name: conv.send, exact: true }).click();
    expect((await submit).status()).toBe(200);
    const res = await settle;
    expect(((await res.json()) as { outcome: string }).outcome).toBe('answered');
    await expect(answer(page, PROGRESS)).toHaveCount(1);
    await expect(byId(page, 'plan-change-answered-aside')).toHaveCount(1);
    expect(await mailboxRows(jobId)).toHaveLength(0);
    await beat();
  });

  await chapter('A clear change is forwarded to the planner', async () => {
    const submit = page.waitForResponse((r) => isPost(r, ASK));
    const settle = page.waitForResponse((r) => isPost(r, SETTLE));
    await composer(page).fill(CHANGE);
    await rail(page).getByRole('button', { name: conv.send, exact: true }).click();
    expect((await submit).status()).toBe(200);
    const res = await settle;
    expect(((await res.json()) as { outcome: string }).outcome).toBe('forwarded');
    await expect(byId(page, 'plan-change-forwarded')).toContainText(conv.midRun.forwardedAck);
    // Not an answer, and not a redirect into a second plan job.
    await expect(answer(page, CHANGE)).toHaveCount(0);
    expect(submitsOf('plan')).toHaveLength(1);
    const rows = (await mailboxRows(jobId)).filter((r) => r.kind === 'turn');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ disposition: 'fold', body: CHANGE });
    expectNoRetiredJob();
    await beat();
  });
});

// ═══ E. Turns stored under the retired verdicts ═════════════════════════════

test('E. a stored debug turn with its landing and a stored new-session confirm still render', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-9216');
  const pctx = await projectContext(seed);
  const bug = await workItemsService.createWorkItem(
    { projectId: seed.projectId, kind: 'bug', title: 'Board drag drops the card one column short' },
    seed.ctx,
  );
  // An OLDER session, as the retired debug path left it: the turn ran as `debug`,
  // its reply carries the landing, and the session was later closed.
  const REPORT = 'Dragging a card drops it one column short.';
  const older = await planChangeSessionsService.startWithFirstTurn(pctx, PROJECT_SCOPE, REPORT);
  const olderAddress = { sessionId: older.id };
  await planChangeSessionsService.recordTurnIntent(
    older.turns.at(-1)!.id,
    'debug',
    pctx,
    { jobId: 'job-stored-debug' },
    olderAddress,
  );
  const landing: DebugLandingDto = {
    outcome: 'diagnose',
    workItemKey: bug.identifier,
    title: bug.title,
    createdInTriage: false,
  };
  await planChangeSessionsService.appendAnswerTurn(
    {
      jobId: 'job-stored-debug',
      body: 'Likely cause: the drop clamp.',
      citations: [],
      debugLanding: landing,
    },
    pctx,
    olderAddress,
  );
  // …and the session after it, holding a `new_session` turn and its confirm.
  const restarted = await planChangeSessionsService.restart(pctx, olderAddress);
  const newer = restarted.session.id;
  const ELSEWHERE = 'Forget this, plan the mobile app instead.';
  await planChangeSessionsService.appendTurn(
    ELSEWHERE,
    pctx,
    { sessionId: newer },
    {
      intent: 'new_session',
    },
  );
  await planChangeSessionsService.requestRestartConfirm(pctx, { sessionId: newer });

  await chapter('The older session reopens with its debug landing', async () => {
    await page.goto(withPlanningOverlay('/dashboard', { kind: 'project', sessionId: older.id }));
    await expect(rail(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    const line = byId(page, 'plan-change-debug-outcome');
    await expect(line).toHaveCount(1);
    await expect(line).toHaveAttribute('data-outcome', 'diagnose');
    // A project-scope session has no anchor, so the stored `diagnose` landing
    // reads as the bug it filed (`debug.filed`), not as a write onto an anchor.
    await expect(line).toContainText(`Filed ${bug.identifier}`);
    await expect(line).toContainText('with the diagnosis. Nothing else changed.');
    await expect(line.getByRole('link', { name: new RegExp(bug.identifier) })).toBeVisible();
    await expect(answer(page, 'Likely cause: the drop clamp.')).toHaveCount(1);
    // No retry is drawn that could submit a debug job.
    await expect(rail(page).getByRole('button', { name: /try again|retry/i })).toHaveCount(0);
    await beat();
  });

  await chapter('The newer session reopens with its new-session confirm', async () => {
    await page.goto(withPlanningOverlay('/dashboard', { kind: 'project', sessionId: newer }));
    await expect(rail(page)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(rail(page).getByText(ELSEWHERE)).toBeVisible();
    const confirm = byId(page, 'planning-restart-confirm-turn');
    await expect(confirm).toHaveCount(1);
    await expect(confirm).toContainText(restart.confirm.body);
    await expect(byId(page, 'planning-restart-confirm')).toBeVisible();
    await expect(byId(page, 'planning-restart-keep')).toBeVisible();
    await expect(rail(page).getByRole('button', { name: /try again|retry/i })).toHaveCount(0);
    // Opening both submitted nothing at all.
    expect(submitted()).toEqual([]);
    await beat();
  });
});

// ═══ F. In Chinese ══════════════════════════════════════════════════════════

test('F. in Chinese, the question case shows no English fallback and no raw key', async ({
  page,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-9216');
  const zconv = zh.planningWorkspace.conversation;
  const ANSWER = '是登录界面，目前没有阻塞。';
  queueAsk({
    intent: 'ask',
    answer: await citing(seed.loginKey, ANSWER),
    citations: [seed.loginKey],
  });
  await setReaderLanguage(page, seed.email, 'zh');

  await chapter('A Chinese reader opens the project thread', async () => {
    await page.goto('/dashboard');
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh', { timeout: FIRST_PAINT_MS });
    await openProjectThread(page, new RegExp(zh.shell.aiCallout.actions.ask.title));
    await beat();
  });

  await chapter('The question is read and answered in Chinese', async () => {
    const { settled } = await askAndSeeItRead(
      page,
      `${seed.loginKey} 是关于什么的？`,
      async () => {
        await composer(page).fill(`${seed.loginKey} 是关于什么的？`);
        await rail(page).getByRole('button', { name: zconv.send, exact: true }).click();
      },
      zconv.act.reading,
    );
    expect(settled.outcome).toBe('answered');
    await expect(answer(page, ANSWER)).toHaveCount(1);
    await expect(chip(page, ANSWER, seed.loginKey)).toBeVisible();
    await expect(answer(page, ANSWER).getByTestId('plan-change-citation-count')).toContainText(
      '依据 1 个工作项作答',
    );
    await beat();
  });

  await chapter('No English fallback and no raw key in the rail', async () => {
    // No English fallback for any of the chrome this story touches, and no raw key.
    const text = (await rail(page).textContent()) ?? '';
    for (const english of [
      conv.progress.reading,
      'Answered from',
      conv.send,
      restart.control,
      conv.composerPlaceholder,
    ]) {
      expect(text, english).not.toContain(english);
    }
    expect(text).not.toMatch(/planningWorkspace\.|conversation\.[a-z]+[A-Z.]/);
    await expect(byId(page, 'planning-restart-control')).toContainText(
      zh.planningWorkspace.restart.control,
    );
    await beat();
  });
});
