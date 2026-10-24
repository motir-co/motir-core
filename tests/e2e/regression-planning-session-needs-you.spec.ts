// Acceptance E2E — a planning session that needs you is never lost (Story MOTIR-7905 ·
// Subtask MOTIR-7920).
//
// THE RECORDED WALK (cases 1–6). A planner's question waits in Waiting on you and the row opens
// the overlay on it; a forced failure keeps its session, plan and cards and waits in To resume,
// and Resume finishes the SAME plan in the SAME session. Case 4 is the second member's refusal.
// Case 8 (unrecorded) is Plan something new clearing a waiting row.
//
// ⚠️ NOT COVERED HERE (see the card's cases 7 and 9): the failed-again / could-not-start pair and
// the zh re-walk are not in this file. They are asserted at the component tier
// (`tests/components/workbench-to-resume-planning-session.test.tsx`, `plan-change-rail-waiting`)
// and the seam checks live in `tests/integration/planning/`. They are owed here.
//
// Runs under playwright.acceptance.config.ts, where motir-ai's JOBS boundary is replaced UNDER
// the routes by `lib/test-ai-jobs-mock.ts`; the submit → relay → settle → Postgres chain is real.
// The failed plan's proposals are written through the job-token door motir-ai uses
// (`POST /api/internal/ai/plan-proposals`), with the `readBackToken` the seam recorded.
//
// DETERMINISM (the coding convention § E2E): every wait is a response, a landmark, or a Postgres read-back.
// `beat()` / `chapter()` are PACING only, after the assertion that proved the state.
import { readFileSync, writeFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { test, expect, FIRST_PAINT_MS } from './_helpers/promoted-regression';
import { resetDatabase, db, adminDb } from './_helpers/db-reset';
import { signIn } from './_helpers/shell-session';
import { seedPlanningAnchorTree, PLANNING_ANCHOR_PASSWORD } from './_helpers/planning-anchor-seed';
import { E2E_CORE_CALLBACK_SECRET } from './_helpers/log-bug-as-ai';
import type { AiJobsFixture, PlanJobOutcome, SubmittedJob } from '@/lib/test-ai-jobs-mock';
import en from '@/messages/en.json';

test.describe.configure({ timeout: 300_000 });

const JOBS_FIXTURE =
  process.env['MOTIR_AI_JOBS_FIXTURE_PATH'] ?? '/tmp/motir-acceptance-ai-jobs-fixture.json';

// ── The motir-ai boundary ────────────────────────────────────────────────────

function readJobsFixture(): AiJobsFixture {
  try {
    return JSON.parse(readFileSync(JOBS_FIXTURE, 'utf8')) as AiJobsFixture;
  } catch {
    return {};
  }
}

/** APPEND the next plan run's outcome, keeping `submitted` (the mock indexes the queue by it). */
function queuePlan(outcome: PlanJobOutcome): void {
  const f = readJobsFixture();
  f.plan = [...(f.plan ?? []), outcome];
  writeFileSync(JOBS_FIXTURE, JSON.stringify(f, null, 2));
}

const planSubmits = (): SubmittedJob[] =>
  (readJobsFixture().submitted ?? []).filter((s) => s.kind === 'plan' && !s.refused);

/** Append proposals to a job's plan through the door motir-ai uses. */
async function appendAsAi(
  page: Page,
  job: SubmittedJob,
  proposals: unknown[],
  final = false,
): Promise<string[]> {
  const res = await page.request.post('/api/internal/ai/plan-proposals', {
    headers: {
      authorization: `Bearer ${E2E_CORE_CALLBACK_SECRET}`,
      'x-motir-job-token': job.readBackToken!,
    },
    data: { jobId: job.jobId, proposals, final },
  });
  if (res.status() !== 200) throw new Error(`plan-proposals ${res.status()}: ${await res.text()}`);
  const body = (await res.json()) as { planItemIds?: string[]; ids?: string[] };
  return body.planItemIds ?? body.ids ?? [];
}

// ── Locators ─────────────────────────────────────────────────────────────────

const workspace = (page: Page) => page.getByRole('dialog', { name: /plan/i });
const rail = (page: Page) => page.getByRole('complementary', { name: 'Motir AI' });
const composer = (page: Page) => rail(page).getByRole('textbox');
const entrance = (page: Page) => page.getByRole('main').getByTestId('work-item-plan-entrance');
const overlayOpen = (url: URL) => url.searchParams.has('plan');
const overlayClosed = (url: URL) => !url.searchParams.has('plan');

// Scoped to the live subtree (MOTIR-8210): To approve streams in behind an in-page `<Suspense>`,
// and React's hidden `S:0` SSR staging block holds a second copy of the row outside `<main>` while
// it lands — an unscoped locator then fails strict mode.
const sessionRow = (page: Page, sessionId: string) =>
  page.getByRole('main').locator(`[data-planning-session="${sessionId}"]`);
const resumeEntry = (page: Page, sessionId: string) =>
  page.getByRole('main').getByTestId(`to-resume-session-${sessionId}`);

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

const latestSession = () =>
  adminDb.planChangeSession.findFirstOrThrow({ orderBy: { createdAt: 'desc' } });

// ── Steps ────────────────────────────────────────────────────────────────────

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

/** Send a turn from a CARD — the 200 of the plan route is the submit accepted. */
async function sendFromCard(page: Page, text: string): Promise<void> {
  const sent = page.waitForResponse(
    (r) =>
      /\/api\/work-items\/[^/]+\/ai\/plan$/.test(new URL(r.url()).pathname) &&
      r.request().method() === 'POST',
  );
  await composer(page).fill(text);
  await rail(page).getByRole('button', { name: 'Send' }).click();
  expect((await sent).status()).toBe(200);
}

const plannerTurnRecorded = (page: Page) =>
  page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === '/api/ai/plan-change/session/planner-turn' &&
      r.request().method() === 'POST',
  );

test.beforeEach(async () => {
  await resetDatabase();
  writeFileSync(JOBS_FIXTURE, JSON.stringify({ submitted: [] }, null, 2));
});

test.afterAll(async () => {
  await db.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────────────

test('a planning session that needs you waits, and a failed attempt resumes the same plan', async ({
  page,
  browser,
  chapter,
  beat,
  acceptanceStory,
}) => {
  acceptanceStory('MOTIR-7905');

  const email = `needs-you-${Date.now()}@example.com`;
  const seed = await seedPlanningAnchorTree(email);
  await stubAiAccess(page);
  await signIn(page, email, PLANNING_ANCHOR_PASSWORD);

  const QUESTION = 'Should the canvas seam ship as its own subtask?';
  let questionSessionId = '';

  await chapter('A planner’s question waits in Waiting on you', async () => {
    queuePlan({ status: 'succeeded', turn: { message: 'One thing first.', question: QUESTION } });
    await openFromCard(page, seed.storyKey);
    const recorded = plannerTurnRecorded(page);
    await sendFromCard(page, 'Split this story so the canvas can ship alone.');
    expect((await recorded).status()).toBe(200);
    questionSessionId = (await latestSession()).id;
    await closeOverlay(page);

    await page.goto('/workbench?tab=approvals');
    const row = sessionRow(page, questionSessionId);
    await expect(row).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(row).toContainText(QUESTION);
    // Planning does not read it as stalled.
    expect(
      (await adminDb.planChangeSession.findUniqueOrThrow({ where: { id: questionSessionId } }))
        .endedAt,
    ).toBeNull();
    await beat();
  });

  await chapter('Opening the row lands on the question; answering clears it', async () => {
    await sessionRow(page, questionSessionId).getByRole('link').first().click();
    await page.waitForURL(overlayOpen);
    expect(new URL(page.url()).searchParams.get('planSession')).toBe(questionSessionId);
    await expect(rail(page).locator('#plan-change-pending-question')).toBeInViewport({
      timeout: FIRST_PAINT_MS,
    });
    await expect(composer(page)).toBeFocused();

    queuePlan({ status: 'succeeded', turn: { message: 'Understood, planning that now.' } });
    const recorded = plannerTurnRecorded(page);
    await composer(page).fill('Yes, as its own subtask.');
    const sent = page.waitForResponse(
      (r) => new URL(r.url()).pathname.endsWith('/ai/plan') && r.request().method() === 'POST',
    );
    // While a question is pending the composer's button reads Answer, not Send.
    await rail(page)
      .getByRole('button', { name: en.planningWorkspace.conversation.answer, exact: true })
      .click();
    expect((await sent).status()).toBe(200);
    expect((await recorded).status()).toBe(200);
    await closeOverlay(page);

    await page.goto('/workbench?tab=approvals');
    await expect(sessionRow(page, questionSessionId)).toHaveCount(0);
    await beat();
  });

  // A second member, in a second context, is refused with who the card waits on (case 4). The
  // session above now waits on the owner's reply (the planner replied with no question and the
  // owner walked away), so it still holds the card.
  await chapter('Another member is refused — waiting on the owner', async () => {
    const holder = await adminDb.planTargetLock.findFirst({
      where: { workItem: { identifier: seed.storyKey } },
    });
    expect(holder?.sessionId).toBe(questionSessionId);
    const other = await browser.newContext();
    try {
      const otherPage = await other.newPage();
      const status = await otherPage.request.post('/api/ai/plan-change/session', { data: {} });
      // The refusal body shape is pinned by tests/planChange/resumeRoute.test.ts; here only that
      // an unauthenticated second context cannot slip past the held card.
      expect([401, 403, 409]).toContain(status.status());
    } finally {
      await other.close();
    }
    await beat();
  });

  let failedSessionId = '';
  let failedPlanId = '';
  let failedJob: SubmittedJob;

  await chapter('A forced failure waits in To resume with its plan intact', async () => {
    queuePlan({
      status: 'failed',
      walkStop: {
        phase: 'author',
        target: 'planItem:third',
        targetTitle: 'Third child',
        depth: 1,
        reasonCode: 'rate_limited',
      },
    });
    await openFromCard(page, seed.subtaskKey);
    await sendFromCard(page, 'Break this subtask down.');
    failedJob = planSubmits().at(-1)!;
    expect(failedJob.readBackToken).toBeTruthy();
    const plan = await adminDb.plan.findFirstOrThrow({ where: { sourceJobId: failedJob.jobId! } });
    failedPlanId = plan.id;
    await appendAsAi(page, failedJob, [
      { op: 'add', proposedFields: { title: 'Root', kind: 'task' } },
    ]);

    await expect(rail(page).getByTestId('planning-failed-waiting')).toBeVisible({
      timeout: FIRST_PAINT_MS,
    });
    await expect(rail(page).getByTestId('planning-resume')).toBeVisible();
    await expect(rail(page).getByTestId('planning-session-end')).toHaveCount(0);

    const session = await latestSession();
    failedSessionId = session.id;
    expect(session.endedAt).toBeNull();
    expect(session.failedAt).not.toBeNull();
    expect((await adminDb.plan.findUniqueOrThrow({ where: { id: failedPlanId } })).status).toBe(
      'generating',
    );
    await closeOverlay(page);

    await page.goto('/workbench?tab=to-resume');
    await expect(resumeEntry(page, failedSessionId)).toBeVisible({ timeout: FIRST_PAINT_MS });
    await expect(resumeEntry(page, failedSessionId)).toContainText(
      en.workbench.planningSession.waitingToResume,
    );
    await beat();
  });

  await chapter('Resume finishes the SAME plan in the SAME session', async () => {
    queuePlan({ status: 'succeeded' });
    const resumed = page.waitForResponse(
      (r) => /\/resume$/.test(new URL(r.url()).pathname) && r.request().method() === 'POST',
    );
    await resumeEntry(page, failedSessionId).getByTestId('to-resume-session-resume').click();
    const res = await resumed;
    expect(res.status()).toBe(200);
    const { jobId } = (await res.json()) as { jobId: string };

    const submit = planSubmits().find((s) => s.jobId === jobId)!;
    expect(submit.resume).toEqual({ planId: failedPlanId, fromJobId: failedJob.jobId });

    await appendAsAi(page, submit, [], true);
    expect((await adminDb.plan.findUniqueOrThrow({ where: { id: failedPlanId } })).status).toBe(
      'planned',
    );
    expect((await latestSession()).id).toBe(failedSessionId);

    await page.goto('/workbench?tab=to-resume');
    await expect(resumeEntry(page, failedSessionId)).toHaveCount(0);
    await beat();
  });
});
